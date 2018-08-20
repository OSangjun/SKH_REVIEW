//https://www.acmicpc.net/problem/1212
//
#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>

#define MAX_LENGTH 333334

int main() {
	int tmp;
	int ans = 0;
	tmp = getchar();
	switch (tmp) {
	case '1':
		printf("1"); break;
	case '2':
		printf("10"); break;
	case '3':
		printf("11"); break;
	case '4':
		printf("100"); break;
	case '5':
		printf("101"); break;
	case '6':
		printf("110"); break;
	case '7':
		printf("111"); break;
	case '0' :
		printf("0"); break;
	}
	while ( (tmp = getchar()) != EOF) {
		switch (tmp) {
		case '0':
			printf("000"); break;
		case '1':
			printf("001"); break;
		case '2':
			printf("010"); break;
		case '3':
			printf("011"); break;
		case '4':
			printf("100"); break;
		case '5':
			printf("101"); break;
		case '6':
			printf("110"); break;
		case '7':
			printf("111"); break;
		}
#ifdef _DEBUG
		printf(" ");
#endif
	}

#ifdef _DEBUG
	system("pause");
#endif

	return 0;
}