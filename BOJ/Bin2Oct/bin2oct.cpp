//https://www.acmicpc.net/problem/1212
//
#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>

#define MAX_LENGTH 1000000

char bin[MAX_LENGTH + 1];

int main() {
	int ans = 0;
	int len = 0;
	int v;
	//char *bin = (char*)malloc(sizeof(char)*MAX_LENGTH+1);
	scanf("%s", bin);
	for (; len < MAX_LENGTH && bin[len] != NULL ; len++) {
		
	}
	int d = (len-1) % 3;
	v = 0;
	for (int i = 0; i < len; i++) {
		v += (bin[i]-'0') << (d--);
		if (d < 0) {
			printf("%d", v);
			v = 0;
			d = 2;
		}
	}

	//free(bin);

#ifdef _DEBUG
	system("pause");
#endif

	return 0;
}