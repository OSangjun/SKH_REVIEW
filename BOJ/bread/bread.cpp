//https://www.acmicpc.net/problem/5000
//
#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>

struct ListItem{
	ListItem* pNext;
	int value;

	ListItem(int v=-1, ListItem* p=NULL) {
		pNext = p;
		value = v;
	}
};

// return  NULL : fail
// return integer : prevNode
ListItem *ListSearch (ListItem *p, int target, int *idx) {
	ListItem *prev =NULL;
	while (p->value != target) {
		prev = p;
		p = p->pNext;
		(*idx)++;
		if (p == NULL) {
			return NULL;
		}
	}
	return prev;
}

void SwapListItems(ListItem* p) {
	// a b c ->  a c b
	ListItem* a, *b, *c;
	a = p;
	b = a->pNext;
	c = b->pNext;
	
	if (c) {
		ListItem * tmp = c->pNext;
		a->pNext = c;
		c->pNext = b;
		b->pNext = tmp;
	}
	else { // c== NULL
		ListItem tmp = *a;
		*a = *b;
		*b = tmp;
		a->pNext = b;
		b->pNext = NULL;
	}
}

int main() {
	int N,tmp,target,remain1,remain2, r, chance =0;
	ListItem root(0,NULL);
	scanf("%d", &N);
	scanf("%d", &tmp); // linked list
	root = ListItem(tmp,NULL);
	ListItem* p = &root, *pRoot, *prev, *tmpp;
	for (int i = 1; i < N; i++) {
		scanf("%d", &tmp); // linked list
		p->pNext = new ListItem(tmp, NULL);
		p = p->pNext;
	}
	int idx = 0;
	p = &root;
	for (int i = 0; i < N-2; i++){
		// get target
		scanf("%d", &target );
		// target hit
		if (target == p->value) {
			pRoot = p->pNext;
			delete p;
			p = pRoot;
			continue;
		}
		
		// search 
		prev = ListSearch(p, target, &idx);
		// delete j-th node 
		tmpp = prev->pNext->pNext;
		delete prev->pNext;
		prev->pNext = tmpp;
		r = idx % 2;
		if (r == 1) {
			// swap values. 
			// (i) (i+2) (i+1) (i+3) ....
			SwapListItems(p);
		}
	}

	// compare last two samples.
	scanf("%d %d", &remain1, &remain2);
	if ( p->value == remain1 && p->pNext->value == remain2) {
		printf("Possible");
	}
	else {
		printf("Impossible");
	}

#ifdef _DEBUG
	system("pause");
#endif

	return 0;
}