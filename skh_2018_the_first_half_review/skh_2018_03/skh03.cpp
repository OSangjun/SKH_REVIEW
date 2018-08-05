#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
struct node {
	int val;
	int idx;
	struct node *l, *r;

	struct node(int v, int i) : val(v), idx(i) { l = NULL; r = NULL; };
};

int put(struct node* root, struct node* newnd) {
	if (root->val >= newnd->val) { // left
		if (root->l == NULL) {
			root->l = newnd;
		}
		else {
			put(root->l, newnd);
		}
	}
	else { // right
		if (root->r == NULL) {
			root->r = newnd;
		}
		else {
			put(root->r, newnd);
		}
	}
	return 0;
}


int main() {
	////write random integers
	//FILE* fp = fopen("values.txt", "w");
	//srand(time(NULL));
	//int tmpv = 0;
	//char tmps[30];
	//int len = 0;
	//for (int i = 0; i < 1024; i++) {
	//	tmpv = rand();
	//	sprintf(tmps, "%d\n", tmpv);
	//	len = 0;
	//	for (int j = 0; j < 30; j++) {
	//		if (tmps[j] != NULL) len++;
	//		else break;;
	//	}
	//	fwrite(tmps, len, 1, fp);
	//}
	//fclose(fp);
	
	// load integers from "values.txt"
	int nums[1024];
	char buff[30];
	FILE *fp = fopen("values.txt", "r");
	for (int i = 0; i < 1024; i++) {
		fgets(buff, 29, fp);
		nums[i] = atoi(buff);
		//printf("%s -> %d \n", buff, nums[i]);
	}
	fclose(fp);

	// define data structre
	struct node root(nums[0],0);
	struct node *newnd;
	
	for (int i = 1; i < 1024; i++) {
		newnd = new struct node(nums[i],i);
		put(&root, newnd);
	}

	// search target num
	int target = 26203;
	int idx = 0, cnt = 0;
	struct node* p = &root;
	while ( p->val != target ) {
		if (p->val >= target) {
			p = p->l;
		}
		else {
			p = p->r;
		}
		cnt++;
	}
	idx = p->idx;
	printf("Target value : %d -> (%s).\nTarget index : %d\ncnt : %d.\n", target, target==p->val?"success":"fail" ,idx,cnt);
	system("pause");
	return 0;
}